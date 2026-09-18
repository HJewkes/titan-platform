# Builtin imports
import os
import sys
from pathlib import Path

# External imports
import requests
from pydantic import BaseModel

# Relative imports
from .utils import helper
from ..constants import MAX_SIZE


# Named functions (no default export concept in Python)
def process_data(input_str: str) -> str:
    return input_str.strip()


VERSION = "1.0.0"


class DataProcessor:
    def process(self, input_str: str) -> str:
        return input_str
