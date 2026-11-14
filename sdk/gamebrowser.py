"""Preferred GameBrowser SDK entry; also works as a standalone copied module."""
try:
    from .stakemode import GameBrowserClient, GameBrowserError, StakeModeClient, StakeModeError
except ImportError:
    from stakemode import GameBrowserClient, GameBrowserError, StakeModeClient, StakeModeError

__all__ = ["GameBrowserClient", "GameBrowserError", "StakeModeClient", "StakeModeError"]
