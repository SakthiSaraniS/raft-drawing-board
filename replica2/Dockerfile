FROM node:24-alpine
WORKDIR /app
COPY package.json .
RUN npm install

# NODE_ENV is set to "production" on cloud deploys (no nodemon, faster startup).
# Locally it defaults to "development" which uses nodemon for hot reload.
CMD ["sh", "-c", "if [ \"$NODE_ENV\" = \"production\" ]; then node index.js; else npx nodemon --legacy-watch index.js; fi"]