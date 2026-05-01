#!/bin/sh

if [ ! -d build ]; then
mkdir build
fi

cd src
find . -type f -name "*.java" -printf "$PWD/%h/%f\n" > ../build/srcfiles.txt
cd ..
javac --release 8 -d ./build "@build/srcfiles.txt"
