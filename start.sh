#!/bin/sh

# Ensure persistent directories exist
mkdir -p /app/uploads /app/data

SHUTDOWN=0
NODE_PID=0
NGINX_PID=0

cleanup() {
    echo "[start.sh] Shutdown signal received. Performing graceful shutdown..."
    SHUTDOWN=1

    if [ "$NODE_PID" -gt 0 ] && kill -0 "$NODE_PID" 2>/dev/null; then
        echo "[start.sh] Stopping Node.js (PID $NODE_PID)..."
        kill -TERM "$NODE_PID" 2>/dev/null || true
    fi

    if [ "$NGINX_PID" -gt 0 ] && kill -0 "$NGINX_PID" 2>/dev/null; then
        echo "[start.sh] Stopping Nginx (PID $NGINX_PID)..."
        kill -QUIT "$NGINX_PID" 2>/dev/null || true
    fi

    # Wait for processes to exit
    wait "$NODE_PID" 2>/dev/null || true
    wait "$NGINX_PID" 2>/dev/null || true
    echo "[start.sh] Shutdown complete."
    exit 0
}

trap cleanup TERM INT QUIT

# Start Nginx in background
nginx -g "daemon off;" &
NGINX_PID=$!
echo "[start.sh] Nginx started with PID $NGINX_PID"

# Start Node supervisor loop in background
start_node_supervisor() {
    cd /app
    while [ "$SHUTDOWN" -eq 0 ]; do
        echo "[start.sh] Starting Node.js server..."
        node server.js &
        CURRENT_PID=$!
        echo "$CURRENT_PID" > /tmp/node.pid

        wait "$CURRENT_PID"
        CODE=$?

        if [ "$SHUTDOWN" -eq 1 ]; then
            break
        fi

        echo "[start.sh] Node.js exited with status $CODE. Restarting in 1 second..."
        sleep 1
    done
}

start_node_supervisor &
SUPERVISOR_PID=$!

# Monitor loop
while [ "$SHUTDOWN" -eq 0 ]; do
    if [ -f /tmp/node.pid ]; then
        NODE_PID=$(cat /tmp/node.pid)
    fi

    # If Nginx stopped, terminate container
    if ! kill -0 "$NGINX_PID" 2>/dev/null; then
        echo "[start.sh] Nginx process stopped. Terminating container..."
        cleanup
        exit 1
    fi

    # If supervisor stopped unexpectedly and shutdown wasn't requested
    if ! kill -0 "$SUPERVISOR_PID" 2>/dev/null; then
        echo "[start.sh] Node supervisor stopped unexpectedly. Terminating container..."
        cleanup
        exit 1
    fi

    sleep 2 &
    wait $! 2>/dev/null || true
done
