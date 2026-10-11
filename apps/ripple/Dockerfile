FROM node:26-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends fonts-dejavu-core python3 ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY contracts/package.json contracts/package.json
RUN npm ci --omit=dev --ignore-scripts
COPY contracts contracts
COPY apps/ripple/src apps/ripple/src
COPY apps/ripple/migrations apps/ripple/migrations
COPY scripts scripts
COPY imports/maple-payments/manifest.json imports/maple-payments/manifest.json
COPY imports/maple-payments/data.zip imports/maple-payments/data.zip
USER node
ENV HOST=0.0.0.0 PORT=8787
EXPOSE 8787
CMD ["node", "apps/ripple/src/main.ts"]
