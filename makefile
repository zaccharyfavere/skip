
export LIBRARY_PATH=$(realpath build/skipruntime)
export SKIPRUNTIME_VERSION=0.0

WITH_VERSION:=build/skipruntime/libskipruntime-$(SKIPRUNTIME_VERSION).so
PACKS_DIR=$(shell pwd)/build/packs

.PHONY: clean-sql
clean-sql:
	skargo clean --manifest-path=sql/Skargo.toml

.PHONY: clean-skipruntime
clean-skipruntime:
	skargo clean --manifest-path=skipruntime-ts/skiplang/ffi/Skargo.toml

.PHONY: build-skipruntime
build-skipruntime:
	skargo build -r --lib --manifest-path=skipruntime-ts/skiplang/ffi/Skargo.toml --out-dir=build/skipruntime
	cp build/skipruntime/libskipruntime.so $(WITH_VERSION)

.PHONY: build
build: build-skipruntime
	cd skipruntime-ts/addon && VERSION="-0.0" node-gyp configure && VERSION="-0.0" node-gyp build
	npm run build

.PHONY: rebuild
rebuild: clean-sql clean-skipruntime build-skipruntime
	cd skipruntime-ts/addon && VERSION="-0.0" node-gyp rebuild
	npm run build


.PHONY: test
test:
	npm run test -w @skipruntime/tests

test-sk-%:
	npm run test -w @skipruntime/tests -- -f $*


build-sk-%:
	npm run build -w @skipruntime/$*

lint-sk-%:
	npm run lint -w @skipruntime/$*

.PHONY: test-all
test-all: build-skipruntime 
	$(MAKE) -C skipruntime-ts build-examples run-test test-wasm-examples test-native-examples test-error-types

.PHONY: install
install: build-skipruntime 
	npm install


.PHONY: test-external
test-external:
	npm run test -w @skipruntime/tests -- -f testExternal 

.PHONY: bootstrap
bootstrap:
	skargo b -r --manifest-path=skiplang/compiler/Skargo.toml
	cp skiplang/compiler/target/host/release/deps/skc-*.ll skiplang/compiler/bootstrap/skc_out64.ll && gzip --best --force skiplang/compiler/bootstrap/skc_out64.ll
	cp skiplang/compiler/target/host/release/deps/skfmt-*.ll skiplang/compiler/bootstrap/skfmt_out64.ll && gzip --best --force skiplang/compiler/bootstrap/skfmt_out64.ll
	skargo b -r --manifest-path=skiplang/skargo/Skargo.toml
	cp skiplang/skargo/target/host/release/deps/skargo-*.ll skiplang/compiler/bootstrap/skargo_out64.ll && gzip --best --force skiplang/compiler/bootstrap/skargo_out64.ll


.PHONY: test-compiler
test-compiler:
	$(MAKE) -C skiplang/compiler STAGE=1
	cd skiplang/compiler && skargo clean
	cd skiplang/compiler && PATH=$(realpath ./stage1/bin):$(PATH) skargo test

clean-sk-%:
	npm run clean -w @skipruntime/$*

build-sl-%:
	npm run build -w @skiplang/$*

clean-sl-%:
	npm run clean -w @skiplang/$*

%:
	$(MAKE) -f Makefile $@