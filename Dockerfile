FROM node:22-alpine
RUN npm install -g @arispay/payagent-mcp
ENTRYPOINT ["payagent-mcp"]
