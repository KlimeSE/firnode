FROM node:20

# Install dependencies required for canvas and TensorFlow
RUN apt-get update && apt-get install -y \
    build-essential \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg-dev \
    libgif-dev \
    librsvg2-dev \
    pkg-config \
    python3 \
    && rm -rf /var/lib/apt/lists/*

# Set environment variables
ENV NODE_OPTIONS="$NODE_OPTIONS --no-deprecation"
ENV TF_CPP_MIN_LOG_LEVEL=2

# Create app directory
WORKDIR /usr/src/app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy resources folder
COPY resources/ ./resources/

# Copy application code
COPY index.js ./


# Default command to run the application
# Users can override input/output paths when running the container
ENTRYPOINT ["node", "index.js"]
CMD ["-h"]