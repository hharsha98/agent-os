#!/bin/sh
# Stand-in login shell for tests (planning decision Q1c): runs Agent OS's
# command (the last argument, after -i -l -c) with /bin/sh, reads no startup
# file and keeps the environment, PATH included, as given. scripts/run-tests.mjs
# sets SHELL to this file, and every test that starts server/index.js sets it
# too, so a server a test starts never reads the owner's shell setup, and a
# real login sh never puts /usr/local/bin or /opt/homebrew/bin ahead of a
# test's fake folder.
for last; do :; done
exec /bin/sh -c "$last"
