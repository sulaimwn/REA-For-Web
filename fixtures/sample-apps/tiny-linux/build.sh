#!/bin/sh
# Builds tiny-notes (x86-64 Linux ELF, dynamically linked to glibc) with gcc in the pinned Debian Node image:
#   docker run --rm -v "$PWD/fixtures/sample-apps/tiny-linux:/src" node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d sh /src/build.sh
# Symbols are kept so Ghidra can name the functions. The binary is only ever read by REA, never run.
set -eu
apt-get update -qq >/dev/null
apt-get install -y -qq --no-install-recommends gcc libc6-dev >/dev/null
gcc -O0 -fno-inline -o /src/tiny-notes /src/tiny_notes.c
gcc --version | head -1
ls -l /src/tiny-notes
