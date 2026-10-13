#!/bin/sh
# Builds tiny-notes.exe (x86-64 Windows) with mingw-w64 in the pinned Debian Node image:
#   docker run --rm -v "$PWD/fixtures/sample-apps/tiny-native:/src" node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d sh /src/build.sh
# Symbols are kept so Ghidra can name the functions. The .exe is only ever read by REA, never run.
set -eu
apt-get update -qq >/dev/null
apt-get install -y -qq --no-install-recommends gcc-mingw-w64-x86-64 >/dev/null
x86_64-w64-mingw32-gcc -O0 -municode -mwindows -o /src/tiny-notes.exe /src/tiny_notes.c -lwininet
x86_64-w64-mingw32-gcc --version | head -1
ls -l /src/tiny-notes.exe
