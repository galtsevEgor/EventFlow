import asyncio
import sys
from collections.abc import Coroutine


def run(coroutine: Coroutine[None, None, None]) -> None:
    if sys.platform == "win32":
        asyncio.run(coroutine, loop_factory=asyncio.SelectorEventLoop)
    else:
        asyncio.run(coroutine)
