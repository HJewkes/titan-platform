import os
from typing import cast

from pkg import helpers


def used(value: int) -> int:
    """Double a value.

    Parameters
    ----------
    value : int
        The value.

    Returns
    -------
    int
        Twice the value.
    """
    return helpers.twice(value)


def unused_function(count):
    """Count things.

    Parameters
    ----------
    other : int
        Not the real argument.
    """
    total = 0
    return count
    print("never")


class UnusedClass:
    attr = 1


def checks(x: int, items: list[int]) -> bool:
    if isinstance(x, int):
        pass
    if x is None:
        return False
    y = cast(int, x)
    return y in items and "a" in items


def noisy():  # noqa
    import sys  # noqa: F401
    z = 1  # type: ignore
    w = 2  # type: ignore[assignment]  # noqa: E501,F841
    return z + w


class Widget:
    def __init__(self) -> None:
        self.size = 3

    def method(self) -> int:
        return 1

    @property
    def prop(self) -> int:
        return 2
