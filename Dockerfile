FROM node:22-alpine
# Pinned to the exact published release so inspectors (Glama) evaluate
# the same version this repo documents. Bump on each release.
RUN npm install -g @arispay/payagent-mcp@4.0.0
ENTRYPOINT ["payagent-mcp"]
