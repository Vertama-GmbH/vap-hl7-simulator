# V.ap HL7 simulator

An HL7 v2 MLLP test receiver. It accepts a connection, ACKs whatever arrives, and logs
what it saw. Nothing is stored and there is no API — the log is the whole output.

It exists so an endpoint can be exercised without sending into a live hospital system.
In V.ap a staff admin arms a *simulator reroute* on one endpoint, which redirects
deliveries here for a bounded time; this is what they get redirected to.

```
ghcr.io/vertama-gmbh/vap-hl7-simulator
```

## What this is, and what it is not

The HL7 work is not ours: it is [node-hl7-server](https://github.com/Bugs5382/node-hl7-server)
and [node-hl7-client](https://github.com/Bugs5382/node-hl7-client) by Shane Froebel,
**MIT licensed**. This repository is a thin wrapper — roughly fifty lines of
`server.js` plus a Dockerfile — and it exists for one reason: to pin things.

Upstream publishes a Docker image recipe, but it pins its git tag while installing the
library with an unpinned `npm i node-hl7-server`. That drifted. By September 2026 a
`node:20.11.0-alpine` base was resolving a 4.x library requiring node ≥ 22 and a changed
API, and the demo server could no longer start at all:

```
HL7ListenerError: version is not defined.
    at Object.<anonymous> (/home/node/app/server.js:5:24)
```

The same commit built in spring and in autumn produced different, and eventually
non-working, images. Pinning a git ref pins only half of a Docker build.

So here the base image is an exact tag and the libraries are exact versions with no
carets. Both have zero transitive dependencies, so the resolution is deterministic
without a lockfile.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `HL7_PORT` | `3000` | port to listen on |
| `HL7_BIND_ADDRESS` | `0.0.0.0` | address to bind |

It accepts any HL7 version (`acceptAnyVersion`). A test receiver that rejects a message
on MSH-12 is testing the wrong thing, and the library refuses to start without either
that flag or an explicit version list — the omission that broke the upstream demo.

## Running it

```sh
docker run --rm -p 2575:3000 ghcr.io/vertama-gmbh/vap-hl7-simulator:v1.0.0
```

Send it something, with MLLP framing:

```sh
printf '\x0bMSH|^~\\&|TEST|TEST|TEST|TEST|20260101120000||ORU^R01|1|P|2.5\r\x1c\r' \
  | nc localhost 2575
```

An `MSA|AA|1` in the reply is an application accept.

## In the cluster

Deployed to the `vap-tools` namespace of the btp cluster, one instance shared by dev and
prod, from
[vertama-deploy](https://github.com/Vertama-GmbH/vertama-deploy/tree/main/hl7-simulator).
See `docs/how-to/hl7-simulator.md` there for how environments are pointed at it and how
to tail its log while debugging.

## Publishing a new image

Run the **Publish image** workflow (Actions → Run workflow) and give it a tag. Then bump
the tag in the deployment manifest in `vertama-deploy` — the cluster is never pointed at
a moving tag.

To move to a newer upstream library, change the pinned versions in `package.json` (and
the base image if the library's `engines` require it), check `server.js` still matches
the API, and publish under a new tag.

## License

This wrapper is MIT. The libraries it packages are MIT and remain the copyright of their
author; their license travels inside the image.
