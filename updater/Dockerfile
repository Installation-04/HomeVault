# syntax=docker/dockerfile:1.7
# The helper behind the "Update" button in HomeVault's settings. It is the only part of
# the stack that talks to Docker, and it has no network port: it watches a folder for a
# request written by an administrator's confirmed action and then runs ./deploy.sh update.
# See docs/SECURITY.md ("In-app updates") for what that access means.
FROM docker:27-cli

ARG VERSION=dev
ARG REVISION=unknown
LABEL org.opencontainers.image.title="HomeVault updater" \
      org.opencontainers.image.description="Applies HomeVault updates on request" \
      org.opencontainers.image.source="https://github.com/Installation-04/HomeVault" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"

# deploy.sh needs bash, git (release files), curl (release lookup), coreutils/gawk/sed/grep.
RUN apk add --no-cache bash git curl coreutils gawk grep sed tar gzip jq ca-certificates

ENV HOMEVAULT_VERSION=${VERSION} \
    HOME=/tmp

COPY updater.sh /usr/local/bin/homevault-updater
RUN chmod 0755 /usr/local/bin/homevault-updater

ENTRYPOINT ["/usr/local/bin/homevault-updater"]
