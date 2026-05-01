@if not exist build mkdir build
@cd src
@dir /s /b *.java > ../build/srcfiles.txt
@cd ..
javac --release 8 -d ./build @build/srcfiles.txt
