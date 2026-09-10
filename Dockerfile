# Pinned at every level, which is the entire point of this repository existing.
#
# Upstream's own image pins its git tag but then runs `npm i node-hl7-server`, which
# resolves at build time. That drifted: a node-20 base ended up with a 4.x library
# needing node >= 22 and a changed API, so the image could no longer start. Same
# commit, different image, depending on the day it was built.
#
# Here the base image is an exact tag, and package.json pins exact library versions
# (no carets). Both libraries have zero dependencies of their own, so this resolves
# identically every time without needing a lockfile.
FROM node:22.23.2-alpine3.23

WORKDIR /app

# Dependencies first, so a change to server.js does not re-resolve them.
COPY package.json .
RUN npm install --omit=dev --no-audit --no-fund

COPY server.js .

# Documentation only — the port is set by HL7_PORT and published by the Service.
EXPOSE 3000

USER node

# Direct exec, no shell wrapper: node is PID 1, so SIGTERM reaches it and its
# shutdown handler runs instead of the container being killed after the grace period.
ENTRYPOINT ["node", "server.js"]
