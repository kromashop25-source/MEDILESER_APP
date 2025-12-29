import json
import logging
import threading
import queue
from time import time
from typing import Any, Dict, List, Optional, Tuple

_SENTINEL = object()

logger = logging.getLogger(__name__)

class ProgressChannel:
    __slots__ = ("queue", "history", "closed", "subscribers", "last_touch", "seq")

    def __init__(self) -> None:
        self.queue: "queue.SimpleQueue[Any]" = queue.SimpleQueue()
        self.history: List[Dict[str, Any]] = []
        self.closed: bool = False
        self.subscribers: int = 0
        self.last_touch: float = time()
        self.seq: int = 0

    def add(self, event: Dict[str, Any]) -> None:
        if self.closed:
            return
        self.last_touch = time()
        if len(self.history) >= 50:
            self.history.pop(0)
        event_with_cursor = dict(event)
        event_with_cursor["cursor"] = self.seq
        self.seq += 1
        self.history.append(event_with_cursor)
        self.queue.put(event_with_cursor)

    def close(self) -> None:
        if not self.closed:
            self.closed = True
            self.queue.put(_SENTINEL)


class ProgressManager:
    def __init__(self) -> None:
        self._channels: Dict[str, ProgressChannel] = {}
        self._lock = threading.Lock()

    def ensure(self, operation_id: str) -> ProgressChannel:
        created = False
        with self._lock:
            channel = self._channels.get(operation_id)
            if channel is None:
                channel = ProgressChannel()
                self._channels[operation_id] = channel
                created = True
            channel.last_touch = time()
        logger.info(
            "Progress ensure operation_id=%s created=%s history=%s",
            operation_id,
            created,
            len(channel.history),
        )
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
        logger.info(
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
            logger.info(
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
        logger.info(
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
        logger.info(
            "Progress subscribe_existing operation_id=%s history=%s queue=%s subscribers=%s ts=%s",
            operation_id,
            len(history),
            queue_size,
            channel.subscribers,
            time(),
        )
        return channel, history

    def get_events_since(
        self, operation_id: str, cursor: int
    ) -> Tuple[ProgressChannel, List[Dict[str, Any]], int]:
        channel = self.ensure(operation_id)
        history = list(channel.history)
        events = [
            ev
            for ev in history
            if isinstance(ev.get("cursor"), int) and ev["cursor"] > cursor
        ]
        cursor_next = events[-1]["cursor"] if events else cursor
        try:
            queue_size = channel.queue.qsize()
        except Exception:
            queue_size = -1
        logger.info(
            "Progress poll operation_id=%s cursor=%s history=%s queue=%s",
            operation_id,
            cursor,
            len(history),
            queue_size,
        )
        return channel, events, cursor_next

    def unsubscribe(self, operation_id: str) -> None:
        with self._lock:
            channel = self._channels.get(operation_id)
            if channel is None:
                return
            channel.subscribers = max(0, channel.subscribers - 1)
            subscribers = channel.subscribers
            closed = channel.closed
            if channel.subscribers == 0 and channel.closed:
                self._channels.pop(operation_id, None)
        logger.info(
            "Progress unsubscribe operation_id=%s subscribers=%s closed=%s",
            operation_id,
            subscribers,
            closed,
        )

    @staticmethod
    def encode_event(event: Dict[str, Any]) -> bytes:
        return (json.dumps(event, ensure_ascii=False) + "\n").encode("utf-8")


progress_manager = ProgressManager()

SENTINEL = _SENTINEL

