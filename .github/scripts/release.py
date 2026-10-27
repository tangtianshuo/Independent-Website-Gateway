#!/usr/bin/env python3
"""Resolve the strict versioned release ref, without allowing master to deploy."""
import os
import re
import sys


def resolve(ref, event="push"):
    match = re.fullmatch(r"refs/(?:heads/release/v|tags/aeroframe-v)((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))", ref)
    if match:
        return match.group(1), "true" if event == "push" else "false"
    if ref.startswith(("refs/heads/release/", "refs/tags/aeroframe-v")):
        raise ValueError("Release ref must be release/vMAJOR.MINOR.PATCH")
    return "", "false"


if __name__ == "__main__":
    try:
        version, publish = resolve(os.environ.get("GITHUB_REF", ""), os.environ.get("GITHUB_EVENT_NAME", ""))
        output = f"version={version}\npublish={publish}\n"
        if os.environ.get("GITHUB_OUTPUT"):
            with open(os.environ["GITHUB_OUTPUT"], "a") as target:
                target.write(output)
        else:
            print(output, end="")
    except ValueError as error:
        sys.exit(str(error))
