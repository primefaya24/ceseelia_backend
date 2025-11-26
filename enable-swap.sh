#!/bin/bash

SWAPFILE="/swapfile"
SWAPSIZE="1G"

# Check if swap already exists
if swapon --show | grep -q "$SWAPFILE"; then
    echo "❗Swap file $SWAPFILE already exists and is active."
    exit 0
fi

# Create swap file
echo "🔧 Creating swap file of size $SWAPSIZE..."
sudo fallocate -l $SWAPSIZE $SWAPFILE || sudo dd if=/dev/zero of=$SWAPFILE bs=1M count=1024

# Set permissions
sudo chmod 600 $SWAPFILE

# Make swap
sudo mkswap $SWAPFILE

# Enable swap
sudo swapon $SWAPFILE
echo "✅ Swap file enabled."

# Persist swap across reboots
if ! grep -q "$SWAPFILE" /etc/fstab; then
    echo "$SWAPFILE none swap sw 0 0" | sudo tee -a /etc/fstab
    echo "🧷 Swap file entry added to /etc/fstab."
fi

# Set swappiness and cache pressure (optional but recommended)
echo "🔧 Tuning kernel swap behavior..."
sudo sysctl vm.swappiness=10
sudo sysctl vm.vfs_cache_pressure=50

# Persist sysctl settings
sudo bash -c 'echo "vm.swappiness=10" >> /etc/sysctl.conf'
sudo bash -c 'echo "vm.vfs_cache_pressure=50" >> /etc/sysctl.conf'

echo "🚀 All done. Current swap usage:"
free -m
