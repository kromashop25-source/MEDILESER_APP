import json
import logging
import threading
import queue
from time import time
from typing import Any, Dict, List, Optional, Tuple

_SENTINEL = object()

logger = logging.getLogger(__name__)

class ProgressChannel:
    __slots__ = ("queue", "history", "closed", "subscribers", "last_touch")

    def __init__(self) -> None:
        self.queue: "queue.SimpleQueue[Any]" = queue.SimpleQueue()
        self.history: List[Dict[str, Any]] = []
        self.closed: bool = False
        self.subscribers: int = 0
        self.last_touch: float = time()

    def add(self, event: Dict[str, Any]) -> None:
        if self.closed:
            return
        self.last_touch = time()
        if len(self.history) >= 50:
            self.history.pop(0)
        self.history.append(event)
        self.queue.put(event)

    def close(self) -> None:
        if not self.closed:
            self.closed = True
            self.queue.put(_SENTINEL)


class ProgressManager:
    def __init__(self) -> None:
        self._channels: Dict[str, ProgressChannel] = {}
        self._lock = threading.Lock()

    def ensure(self, operation_id: str) -> ProgressChannel:
        with self._lock:
            channel = self._channels.get(operation_id)
            if channel is None:
                channel = ProgressChannel()
                self._channels[operation_id] = channel
            channel.last_touch = time()
            return channel

    def get_channel(self, operation_id: str) -> Optional[ProgressChannel]:
        with self._lock:
            return self._channels.get(operation_id)

    def emit(self, operation_id: Optional[str], event: Dict[str, Any]) -> None:
        if not operation_id:
            return
        channel = self.ensure(operation_id)
        channel.add(event)
        try:
            queue_size = channel.queue.qsize()
        except Exception:
            queue_size = -1
        logger.debug(
            "Progress emit operation_id=%s history=%s queue=%s ts=%s",
            operation_id,
            len(channel.history),
            queue_size,
            time(),
        )

    def finish(self, operation_id: Optional[str]) -> None:
        if not operation_id:
            return
        with self._lock:
            channel = self._channels.get(operation_id)
        if channel is not None:
            try:
                queue_size = channel.queue.qsize()
            except Exception:
                queue_size = -1
            logger.debug(
                "Progress finish operation_id=%s history=%s queue=%s ts=%s",
                operation_id,
                len(channel.history),
                queue_size,
                time(),
            )
            channel.close()

    def subscribe(self, operation_id: str) -> Tuple[ProgressChannel, List[Dict[str, Any]]]:
        channel = self.ensure(operation_id)
        channel.subscribers += 1
        history = list(channel.history)
        try:
            queue_size = channel.queue.qsize()
        except Exception:
            queue_size = -1
        logger.debug(
            "Progress subscribe operation_id=%s history=%s queue=%s subscribers=%s ts=%s",
            operation_id,
            len(history),
            queue_size,
            channel.subscribers,
            time(),
        )
        return channel, history

    def subscribe_existing(
        self, operation_id: str
    ) -> Optional[Tuple[ProgressChannel, List[Dict[str, Any]]]]:
        with self._lock:
            channel = self._channels.get(operation_id)
            if channel is None:
                return None
            channel.subscribers += 1
            history = list(channel.history)
        try:
            queue_size = channel.queue.qsize()
        except Exception:
            queue_size = -1
        logger.debug(
            "Progress subscribe_existing operation_id=%s history=%s queue=%s subscribers=%s ts=%s",
            operation_id,
            len(history),
            queue_size,
            channel.subscribers,
            time(),
        )
        return channel, history

    def unsubscribe(self, operation_id: str) -> None:
        with self._lock:
            channel = self._channels.get(operation_id)
            if channel is None:
                return
            channel.subscribers = max(0, channel.subscribers - 1)
            if channel.subscribers == 0 and channel.closed:
                self._channels.pop(operation_id, None)

    @staticmethod
    def encode_event(event: Dict[str, Any]) -> bytes:
        return (json.dumps(event, ensure_ascii=False) + "\n").encode("utf-8")


progress_manager = ProgressManager()

SENTINEL = _SENTINEL

