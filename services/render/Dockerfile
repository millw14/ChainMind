# THE BUILD CONTEXT IS THE REPOSITORY ROOT, NOT THIS DIRECTORY.
#
# That is deliberate and it is the reason there is no second copy of lib/safe-fetch.js
# under services/. The SSRF primitives were adversarially tested — a 56-URL battery, live
# DNS against nip.io and localtest.me, fake resolvers, DNS-rebinding flips, redirect
# ladders and a hostile origin bound on 127.0.0.1:80 — and a copy of them in this
# directory would be a second implementation the moment either one changed. So the image
# COPYs the real modules in from the root and the service imports them across the
# directory boundary, which means Railway must build from the repository root with
# `dockerfilePath: services/render/Dockerfile`. That is exactly what the root railway.json
# says. See README.md.
#
# THE BASE IMAGE IS THE OFFICIAL PLAYWRIGHT ONE, AND ITS TAG MUST MATCH THE npm VERSION.
# Chromium needs a long list of shared libraries (libnss3, libatk, libcups, libdrm,
# libxkbcommon, libgbm, libasound and about thirty more), and a bare nixpacks or
# node:slim build has none of them. The failure is not a clear error at build time — it is
# "browserType.launch: Target closed" at run time, which is the usual way this deployment
# fails. This image ships them.
#
# The tag and the version in package.json are pinned to the same number ON PURPOSE:
# Playwright refuses to drive a browser build it was not compiled against, so a floating
# tag turns into a runtime error the first time Microsoft publishes a new one.
FROM mcr.microsoft.com/playwright:v1.62.1-noble

ENV NODE_ENV=production \
    # The browsers this image already ships. Named explicitly so npm's postinstall finds
    # them instead of downloading a second copy into the layer.
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    # Node is PID 1 here; keep its own heap modest so the memory ceiling belongs to
    # Chromium, which is what actually needs it.
    NODE_OPTIONS=--max-old-space-size=256

WORKDIR /app

# Dependencies first, so a change to the service's source does not reinstall them.
COPY services/render/package.json services/render/package-lock.json* ./services/render/
RUN cd services/render && npm ci --omit=dev --no-audit --no-fund

# THE TWO MODULES THE SERVICE SHARES WITH THE MAIN APP, and only those two. lib/ holds
# thirty-odd modules that reach chains, indexers, Redis and an LLM; none of them belongs
# in a process that runs the investigated party's JavaScript, and none of them is copied
# here. If a future import needs a third file, that is worth a second look before it is
# worth a COPY line.
COPY lib/safe-fetch.js lib/request-budget.js ./lib/

COPY services/render ./services/render

# Chromium's sandbox needs a non-root user. The image provides one; using it is also why
# RENDER_DISABLE_SANDBOX can stay off by default.
USER pwuser

WORKDIR /app/services/render
EXPOSE 8080
CMD ["node", "server.js"]
