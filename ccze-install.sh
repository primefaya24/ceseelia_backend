# 📚 Install ccze for colored logs
echo "🎨 Installing ccze (colored log viewer)..."

sudo yum groupinstall -y "Development Tools"
sudo yum install -y ncurses-devel pcre-devel automake autoconf libtool git

cd /usr/local/src
sudo git clone https://github.com/cornet/ccze.git
cd ccze
chmod +x autogen.sh
sudo ./autogen.sh
sudo ./configure
sudo make
sudo make install

echo "🎉 ccze installed. Try: echo 'log line' | ccze -A"