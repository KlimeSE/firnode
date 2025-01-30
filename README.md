# firnode

NodeJS version of [Foxhole Inventory Report (FIR)](https://github.com/GICodeWarrior/fir) - Extracts inventory from Foxhole stockpile screenshots.

## Run with Docker

```bash
docker pull ghcr.io/klimese/firnode:latest
docker run -v $(pwd):/usr/src/app ghcr.io/klimese/firnode -i p1.png -o output.json
```

## Local Install

### Requirements
```
node v22
npm v10.9
```

### Clone the repository
```bash
git clone https://github.com/klimese/firnode.git
cd firnode
npm install
```

### Run with node
```bash
node index.js -i stockpile.png -o output.json
```