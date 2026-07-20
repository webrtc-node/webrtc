cmake_minimum_required(VERSION 3.21)

if(DEFINED ENV{CMAKE_TOOLCHAIN_FILE} AND NOT DEFINED CMAKE_TOOLCHAIN_FILE)
  set(CMAKE_TOOLCHAIN_FILE "$ENV{CMAKE_TOOLCHAIN_FILE}" CACHE FILEPATH
      "Toolchain file provided by the native build environment.")
endif()

if(DEFINED ENV{VCPKG_TARGET_TRIPLET} AND NOT DEFINED VCPKG_TARGET_TRIPLET)
  set(VCPKG_TARGET_TRIPLET "$ENV{VCPKG_TARGET_TRIPLET}" CACHE STRING
      "vcpkg target triplet provided by the native build environment.")
endif()

if(DEFINED ENV{VCPKG_INSTALLED_DIR} AND NOT DEFINED VCPKG_INSTALLED_DIR)
  set(VCPKG_INSTALLED_DIR "$ENV{VCPKG_INSTALLED_DIR}" CACHE PATH
      "vcpkg installed package directory provided by the native build environment.")
endif()

project(webrtc_node LANGUAGES CXX)

include(FetchContent)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

if(DEFINED napi_build_version)
  set(WEBRTC_NODE_NAPI_VERSION "${napi_build_version}")
else()
  set(WEBRTC_NODE_NAPI_VERSION 8)
endif()

set(WEBRTC_NODE_STATIC_OPENSSL OFF CACHE BOOL
    "Prefer static OpenSSL libraries when building release prebuilds.")

set(WEBRTC_NODE_BUILD_NATIVE_TESTS OFF CACHE BOOL
    "Build opt-in libdatachannel regression executables.")

if(NOT DEFINED CMAKE_JS_INC)
  message(FATAL_ERROR "This project is intended to be built through cmake-js.")
endif()

execute_process(
  COMMAND node -p "require('node-addon-api').include_dir"
  WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}
  OUTPUT_VARIABLE NODE_ADDON_API_DIR
  OUTPUT_STRIP_TRAILING_WHITESPACE
)
string(REPLACE "\"" "" NODE_ADDON_API_DIR "${NODE_ADDON_API_DIR}")
string(REPLACE "\\" "/" NODE_ADDON_API_DIR "${NODE_ADDON_API_DIR}")

set(LIBDATACHANNEL_PINNED_COMMIT "188ec93f6a0b01c2032ddb4c8c013118f7f30232" CACHE STRING
    "Audited libdatachannel commit for this binding.")

set(LIBDATACHANNEL_REPOSITORY "https://github.com/paullouisageneau/libdatachannel.git" CACHE STRING
    "Repository used when the pinned libdatachannel checkout is not present locally.")

if(EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/../../libdatachannel/CMakeLists.txt")
  set(WEBRTC_NODE_DEFAULT_LIBDATACHANNEL_SOURCE_DIR
      "${CMAKE_CURRENT_SOURCE_DIR}/../../libdatachannel")
else()
  set(WEBRTC_NODE_DEFAULT_LIBDATACHANNEL_SOURCE_DIR
      "${CMAKE_CURRENT_SOURCE_DIR}/libdatachannel")
endif()

set(LIBDATACHANNEL_SOURCE_DIR "${WEBRTC_NODE_DEFAULT_LIBDATACHANNEL_SOURCE_DIR}" CACHE PATH
    "Path to the pinned libdatachannel checkout.")

set(LIBDATACHANNEL_VERIFY_PINNED_COMMIT ON CACHE BOOL
    "Verify that a git libdatachannel checkout matches LIBDATACHANNEL_PINNED_COMMIT.")

set(WEBRTC_NODE_LIBDATACHANNEL_PATCH
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/0001-libdatachannel-serialize-dtls-startup.patch")

function(verify_libdatachannel_pin source_dir)
  if(NOT LIBDATACHANNEL_VERIFY_PINNED_COMMIT)
    return()
  endif()

  find_package(Git QUIET)
  if(NOT Git_FOUND)
    message(WARNING "Git was not found; cannot verify libdatachannel commit pin.")
    return()
  endif()

  execute_process(
    COMMAND "${GIT_EXECUTABLE}" -C "${source_dir}" rev-parse HEAD
    OUTPUT_VARIABLE LIBDATACHANNEL_ACTUAL_COMMIT
    OUTPUT_STRIP_TRAILING_WHITESPACE
    ERROR_QUIET
    RESULT_VARIABLE LIBDATACHANNEL_GIT_RESULT
  )

  if(LIBDATACHANNEL_GIT_RESULT EQUAL 0)
    if(NOT LIBDATACHANNEL_ACTUAL_COMMIT STREQUAL LIBDATACHANNEL_PINNED_COMMIT)
      message(FATAL_ERROR
        "libdatachannel checkout at ${source_dir} is ${LIBDATACHANNEL_ACTUAL_COMMIT}, "
        "but this binding is pinned to ${LIBDATACHANNEL_PINNED_COMMIT}. "
        "Update the checkout or configure LIBDATACHANNEL_VERIFY_PINNED_COMMIT=OFF intentionally.")
    endif()
  else()
    message(WARNING "Could not verify libdatachannel commit at ${source_dir}; assuming vendored source.")
  endif()
endfunction()

function(prepare_patched_libdatachannel_source source_dir output_var)
  if(NOT EXISTS "${WEBRTC_NODE_LIBDATACHANNEL_PATCH}")
    message(FATAL_ERROR
      "Required libdatachannel patch is missing: ${WEBRTC_NODE_LIBDATACHANNEL_PATCH}")
  endif()

  find_package(Git REQUIRED)
  set(patched_root "${CMAKE_BINARY_DIR}/ldcp-overlay")
  set(patched_dir "${patched_root}/src/impl")
  set(patched_source "${patched_dir}/peerconnection.cpp")
  file(REMOVE_RECURSE "${patched_root}")
  file(MAKE_DIRECTORY "${patched_dir}")
  file(GLOB libdatachannel_impl_headers "${source_dir}/src/impl/*.hpp")
  file(COPY ${libdatachannel_impl_headers} DESTINATION "${patched_dir}")
  file(COPY "${source_dir}/src/impl/peerconnection.cpp" DESTINATION "${patched_dir}")

  execute_process(
    COMMAND "${GIT_EXECUTABLE}" apply --check --unidiff-zero --whitespace=nowarn
            "${WEBRTC_NODE_LIBDATACHANNEL_PATCH}"
    WORKING_DIRECTORY "${patched_root}"
    RESULT_VARIABLE patch_check_result
    ERROR_VARIABLE patch_check_error
  )
  if(NOT patch_check_result EQUAL 0)
    message(FATAL_ERROR
      "libdatachannel patch does not apply to ${LIBDATACHANNEL_PINNED_COMMIT}: "
      "${patch_check_error}")
  endif()

  execute_process(
    COMMAND "${GIT_EXECUTABLE}" apply --unidiff-zero --whitespace=nowarn
            "${WEBRTC_NODE_LIBDATACHANNEL_PATCH}"
    WORKING_DIRECTORY "${patched_root}"
    RESULT_VARIABLE patch_result
    ERROR_VARIABLE patch_error
  )
  if(NOT patch_result EQUAL 0)
    message(FATAL_ERROR "Failed to apply libdatachannel patch: ${patch_error}")
  endif()

  set(${output_var} "${patched_source}" PARENT_SCOPE)
endfunction()

function(replace_libdatachannel_peerconnection_source target source_dir patched_source)
  set(original_source "${source_dir}/src/impl/peerconnection.cpp")
  get_target_property(target_sources "${target}" SOURCES)
  list(FIND target_sources "${original_source}" source_index)
  if(source_index EQUAL -1)
    message(FATAL_ERROR "Could not replace ${original_source} on target ${target}.")
  endif()
  list(REMOVE_AT target_sources ${source_index})
  list(INSERT target_sources ${source_index} "${patched_source}")
  set_property(TARGET "${target}" PROPERTY SOURCES "${target_sources}")
endfunction()

if(EXISTS "${LIBDATACHANNEL_SOURCE_DIR}/CMakeLists.txt")
  set(LIBDATACHANNEL_RESOLVED_SOURCE_DIR "${LIBDATACHANNEL_SOURCE_DIR}")
else()
  message(STATUS
    "libdatachannel source not found at ${LIBDATACHANNEL_SOURCE_DIR}; "
    "fetching ${LIBDATACHANNEL_REPOSITORY} at ${LIBDATACHANNEL_PINNED_COMMIT}.")
  # Keep the FetchContent name short so source-package builds stay below
  # Windows path length limits in ordinary temp directories.
  FetchContent_Declare(
    ldc
    GIT_REPOSITORY "${LIBDATACHANNEL_REPOSITORY}"
    GIT_TAG "${LIBDATACHANNEL_PINNED_COMMIT}"
    GIT_SHALLOW FALSE
    GIT_SUBMODULES
      deps/plog
      deps/usrsctp
      deps/libjuice
      deps/libsrtp
    GIT_SUBMODULES_RECURSE TRUE
    # Populate here and add the dependency only after all build options are forced below.
    SOURCE_SUBDIR __webrtc_node_populate_only
  )
  FetchContent_MakeAvailable(ldc)
  set(LIBDATACHANNEL_RESOLVED_SOURCE_DIR "${ldc_SOURCE_DIR}")
endif()

file(REAL_PATH "${LIBDATACHANNEL_RESOLVED_SOURCE_DIR}" LIBDATACHANNEL_RESOLVED_SOURCE_DIR)
verify_libdatachannel_pin("${LIBDATACHANNEL_RESOLVED_SOURCE_DIR}")
prepare_patched_libdatachannel_source(
  "${LIBDATACHANNEL_RESOLVED_SOURCE_DIR}"
  LIBDATACHANNEL_PATCHED_PEERCONNECTION_SOURCE)

set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(BUILD_SHARED_DEPS_LIBS OFF CACHE BOOL "" FORCE)
set(NO_MEDIA OFF CACHE BOOL "" FORCE)
set(NO_WEBSOCKET ON CACHE BOOL "" FORCE)
set(NO_EXAMPLES ON CACHE BOOL "" FORCE)
set(NO_TESTS ON CACHE BOOL "" FORCE)
set(PREFER_SYSTEM_LIB OFF CACHE BOOL "" FORCE)

if(WEBRTC_NODE_STATIC_OPENSSL)
  set(OPENSSL_USE_STATIC_LIBS TRUE)
endif()

add_subdirectory("${LIBDATACHANNEL_RESOLVED_SOURCE_DIR}" "${CMAKE_BINARY_DIR}/libdatachannel" EXCLUDE_FROM_ALL)
replace_libdatachannel_peerconnection_source(
  datachannel
  "${LIBDATACHANNEL_RESOLVED_SOURCE_DIR}"
  "${LIBDATACHANNEL_PATCHED_PEERCONNECTION_SOURCE}")
replace_libdatachannel_peerconnection_source(
  datachannel-static
  "${LIBDATACHANNEL_RESOLVED_SOURCE_DIR}"
  "${LIBDATACHANNEL_PATCHED_PEERCONNECTION_SOURCE}")

find_package(OpenSSL REQUIRED)

add_library(webrtc_node_certificate STATIC
  src/native/certificate.cc
)

target_link_libraries(webrtc_node_certificate PRIVATE
  OpenSSL::Crypto
)

add_library(${PROJECT_NAME} SHARED
  src/native/addon.cc
  ${CMAKE_JS_SRC}
)

set_target_properties(${PROJECT_NAME} PROPERTIES
  PREFIX ""
  SUFFIX ".node"
)

target_include_directories(${PROJECT_NAME} PRIVATE
  ${CMAKE_JS_INC}
  ${NODE_ADDON_API_DIR}
)

target_compile_definitions(${PROJECT_NAME} PRIVATE
  NAPI_VERSION=${WEBRTC_NODE_NAPI_VERSION}
  RTC_STATIC
)

target_link_libraries(${PROJECT_NAME} PRIVATE
  ${CMAKE_JS_LIB}
  LibDataChannel::LibDataChannelStatic
  webrtc_node_certificate
)

if(WEBRTC_NODE_BUILD_NATIVE_TESTS)
  add_executable(webrtc_node_dtls_startup_race EXCLUDE_FROM_ALL
    test/native/dtls-startup-race.cpp
  )
  target_compile_definitions(webrtc_node_dtls_startup_race PRIVATE RTC_STATIC)
  target_link_libraries(webrtc_node_dtls_startup_race PRIVATE
    LibDataChannel::LibDataChannelStatic
  )
  if(MSVC)
    target_compile_options(webrtc_node_dtls_startup_race PRIVATE /EHsc)
  else()
    target_compile_options(webrtc_node_dtls_startup_race PRIVATE -Wall -Wextra -Wpedantic)
  endif()
endif()

if(UNIX AND NOT APPLE)
  target_compile_options(${PROJECT_NAME} PRIVATE
    -fvisibility=hidden
    -fvisibility-inlines-hidden
  )
  target_link_options(${PROJECT_NAME} PRIVATE
    "LINKER:--exclude-libs,ALL"
  )
endif()

if(MSVC)
  target_compile_options(${PROJECT_NAME} PRIVATE /EHsc /bigobj)
else()
  target_compile_options(${PROJECT_NAME} PRIVATE -Wall -Wextra -Wpedantic)
endif()
