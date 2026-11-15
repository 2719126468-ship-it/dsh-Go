#!/usr/bin/env bash
for p in /proc/[0-9]*; do
  c=$(tr '\0' ' ' < "$p/cmdline" 2>/dev/null) || continue
  case "$c" in *bridge.py*) kill -9 "${p#/proc/}" 2>/dev/null && echo "killed ${p#/proc/}";; esac
done
