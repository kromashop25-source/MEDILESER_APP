from __future__ import annotations

import threading
from typing import Dict, Optional


class CancelToken:
    def __init__(self) -> None:
        self._event = threading.Event()

    def cancel(self) -> None:
        self._event.set()

    def is_cancelled(self) -> bool:
        return self._event.is_set()


class CancelManager:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._tokens: Dict[str, CancelToken] = {}

    def create(self, operation_id: str) -> CancelToken:
        with self._lock:
            token = CancelToken()
            self._tokens[operation_id] = token
            return token

    def get(self, operation_id: str) -> Optional[CancelToken]:
        with self._lock:
            return self._tokens.get(operation_id)

    def cancel(self, operation_id: str) -> bool:
        token = self.get(operation_id)
        if token is None:
            return False
        token.cancel()
        return True

    def remove(self, operation_id: str) -> None:
        with self._lock:
            self._tokens.pop(operation_id, None)


cancel_manager = CancelManager()
