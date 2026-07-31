# THE BUILD CONTEXT IS THE REPOSITORY ROOT, NOT THIS DIRECTORY.
#
# The same arrangement services/render/Dockerfile uses and for the same reason: the SSRF
# primitives in lib/safe-fetch.js were adversarially tested — a 56-URL battery, live DNS
# against nip.io and localtest.me, fake resolvers, DNS-rebinding flips, redirect ladders and
# a hostile origin bound on 127.0.0.1:80 — and a copy of them under services/ would be a
# second implementation the moment either one changed. The image COPYs the real modules in
# and this service imports them across the directory boundary, which means Railway must
# build from the repository ROOT with `dockerfilePath: services/research/Dockerfile`. That
# is what services/research/railway.json says. See README.md.
#
# WHY THIS ONE COPIES ALL OF lib/ WHEN THE RENDER SERVICE COPIES EXACTLY TWO FILES, because
# the difference is the threat model rather than convenience.
#
#   services/render RUNS THE INVESTIGATED PARTY'S JAVASCRIPT. Anything in that process is
#   one renderer escape away from an attacker, so it holds two shared modules and one
#   secret, and caching lives on the app side precisely so no store credential is in the
#   room with the browser.
#
#   THIS SERVICE NEVER EXECUTES THIRD-PARTY CODE. It fetches bytes through safe-fetch, reads
#   them, and asks a model about them; when a page needs a browser it calls the render
#   service over HTTP and the browser stays over there. So it is the same kind of process as
#   the Next.js app — an analytical one holding credentials — and it needs the app's real
#   analytical modules: lib/site-analysis.js for the untrusted-content pipeline,
#   lib/project-profile.js for the chain half, lib/store.js for the job queue,
#   lib/render-client.js for the browser leg. Reimplementing any of those here would produce
#   the second, weaker copy this repository keeps refusing to have.
#
#   THE LINE THAT MUST NOT BE CROSSED: no browser in this image. A future `playwright`
#   dependency here would put hostile code in the process that holds the Groq key, the store
#   credentials and the render secret, and would undo the whole separation.
#
# NO PLAYWRIGHT MEANS NO PLAYWRIGHT BASE IMAGE. This is plain node:22-slim, which is a few
# hundred megabytes rather than a few gigabytes, and it starts in a second.
FROM node:22-slim

ENV NODE_ENV=production \
    # A research job holds a transcript, several fetched pages and a JSON report at once.
    # 512MB is comfortable for one worker; raise it with RESEARCH_WORKERS if that is raised.
    NODE_OPTIONS=--max-old-space-size=448

WORKDIR /app

# Dependencies first, so a change to the service's source does not reinstall them.
# DEPENDENCIES INSTALL AT /app, NOT AT /app/services/research, AND THAT IS THE WHOLE POINT.
#
# Node resolves a bare specifier by walking UP from the IMPORTING file. The service imports
# lib/project-profile.js, which imports lib/ask-evidence.js, which imports "viem" — and that
# import is resolved from /app/lib/, so Node looks in /app/lib/node_modules and then
# /app/node_modules. It never looks in /app/services/research/node_modules.
#
# Installing under services/research therefore BUILT CLEANLY and crashed at boot with
# "Cannot find package viem imported from /app/lib/ask-evidence.js" — a failure that only
# appears at run time, on the platform, after a green build. services/render never hit it
# because it copies only two lib/ files and neither imports a package.
COPY services/research/package.json services/research/package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

# THE APP'S REAL MODULES, not copies. See the header for why this is the whole directory
# here and two files in services/render.
COPY lib ./lib
# lib/stock-tokens.js and lib/market-evidence.js import this registry as JSON. Without it
# the chain leg fails to load at all, and it fails at import time rather than at use time —
# which is the good direction, but only if the file is here.
COPY config ./config
# THE DOOR, imported rather than reimplemented: services/research/server.js uses the render
# service's timing-safe checkAuth. One implementation of a secret comparison, not two.
COPY services/render/lib/auth.js ./services/render/lib/auth.js

COPY services/research ./services/research

# Nothing here needs root. The base image ships a `node` user.
USER node

WORKDIR /app/services/research
EXPOSE 8090
CMD ["node", "server.js"]
