FROM node:lts-alpine AS builder

WORKDIR /app

COPY . ./

RUN npm install

FROM node:lts-alpine AS prod

WORKDIR /app

COPY package*.json .npmrc ./

RUN npm install --omit=dev --ignore-scripts


WORKDIR /app/build

COPY --from=builder /app/build .



# Run the MCP server
CMD [ "node", "./index.js" ]
