# Use official Node.js runtime as a lightweight base image
FROM node:20-alpine

# Set working directory
WORKDIR /usr/src/app

# Copy package.json and package-lock.json (if any)
COPY package*.json ./

# Install only production dependencies
RUN npm install --production

# Copy the compiled JS output and other needed files
COPY dist ./dist

# If you have other static files needed at runtime, copy them too:
# COPY public ./public

# Expose your app's port
EXPOSE 3100

# Start the app using the compiled JS in dist
CMD ["node", "dist/index.js"]
