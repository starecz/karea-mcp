FROM node:20-alpine

# Preinstall the published npm package so cold-start is fast for Glama introspection
RUN npm install -g karea-mcp@0.4.1

# Stub key so the process starts cleanly; tools/list does not call Karea's API
ENV KAREA_API_KEY=glama-introspection-stub
ENV KAREA_URL=https://karea.app

# stdio MCP transport
ENTRYPOINT ["karea-mcp"]
