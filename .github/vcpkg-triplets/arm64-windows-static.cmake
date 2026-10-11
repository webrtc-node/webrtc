set(VCPKG_TARGET_ARCHITECTURE arm64)
set(VCPKG_CRT_LINKAGE static)
set(VCPKG_LIBRARY_LINKAGE static)

# Optimized MSVC OpenSSL C code crashes during ARM64 DTLS handshakes.
# Keep static linkage and assembly implementations while avoiding that build.
if(PORT STREQUAL "openssl")
  set(VCPKG_C_FLAGS_RELEASE "/Od")
  set(VCPKG_CXX_FLAGS_RELEASE "/Od")
endif()
