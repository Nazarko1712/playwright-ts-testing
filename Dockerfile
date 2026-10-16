# Playwright ships an official image with the browsers and all system libraries
# already installed. Pinning the tag to the exact Playwright version matters:
# a browser build newer than the client library can fail in confusing ways.
FROM mcr.microsoft.com/playwright:v1.63.0-jammy

WORKDIR /app

# Copy manifests first so `npm ci` is cached until the lockfile changes.
COPY package.json package-lock.json ./

# `npm ci` (not `npm install`) in CI: it installs exactly the lockfile and fails
# if package.json and the lockfile disagree - reproducible by construction.
RUN npm ci

COPY . .

ENV CI=true

CMD ["npx", "playwright", "test"]
