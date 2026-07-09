import assert from "node:assert/strict";
import test from "node:test";
import {
  AsyncSemaphore,
  resolveMaxConcurrentLaunches
} from "../src/main/services/async-semaphore.js";

// O semaforo escalona o lancamento de navegadores: no maximo N launches pesados
// ao mesmo tempo. Estes testes provam o contrato de concorrencia sem browser.

test("AsyncSemaphore: nunca deixa mais que N permits ativos ao mesmo tempo", async () => {
  const semaphore = new AsyncSemaphore(2);
  let active = 0;
  let peak = 0;
  const task = async () => {
    const release = await semaphore.acquire();
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    release();
  };
  await Promise.all(Array.from({ length: 8 }, () => task()));
  assert.equal(peak, 2);
  assert.equal(active, 0);
});

test("AsyncSemaphore: enfileira e libera em ordem FIFO", async () => {
  const semaphore = new AsyncSemaphore(1);
  const order: number[] = [];
  const release0 = await semaphore.acquire();
  // Dois esperando pelo unico permit.
  const p1 = semaphore.acquire().then((release) => {
    order.push(1);
    release();
  });
  const p2 = semaphore.acquire().then((release) => {
    order.push(2);
    release();
  });
  assert.equal(semaphore.pending, 2);
  release0();
  await Promise.all([p1, p2]);
  assert.deepEqual(order, [1, 2]);
});

test("AsyncSemaphore: release e idempotente (chamar 2x nao cria permit extra)", async () => {
  const semaphore = new AsyncSemaphore(1);
  const release = await semaphore.acquire();
  release();
  release();
  assert.equal(semaphore.permits, 1);
  // Ainda consegue adquirir normalmente e o permit volta a 0.
  const release2 = await semaphore.acquire();
  assert.equal(semaphore.permits, 0);
  release2();
  assert.equal(semaphore.permits, 1);
});

test("AsyncSemaphore: construtor sanitiza permits <= 0 para 1", () => {
  assert.equal(new AsyncSemaphore(0).permits, 1);
  assert.equal(new AsyncSemaphore(-3).permits, 1);
});

test("resolveMaxConcurrentLaunches: deriva de nucleos com clamp [2,4]", () => {
  assert.equal(resolveMaxConcurrentLaunches({}, 8), 4); // clamp superior
  assert.equal(resolveMaxConcurrentLaunches({}, 4), 3); // cores-1
  assert.equal(resolveMaxConcurrentLaunches({}, 2), 2); // clamp inferior
  assert.equal(resolveMaxConcurrentLaunches({}, 1), 2); // clamp inferior
});

test("resolveMaxConcurrentLaunches: env sobrescreve e e limitado a [1,64]", () => {
  assert.equal(resolveMaxConcurrentLaunches({ SPIDER_MAX_CONCURRENT_LAUNCHES: "6" }, 4), 6);
  assert.equal(resolveMaxConcurrentLaunches({ SPIDER_MAX_CONCURRENT_LAUNCHES: "999" }, 4), 64);
  assert.equal(resolveMaxConcurrentLaunches({ SPIDER_MAX_CONCURRENT_LAUNCHES: "0" }, 4), 3); // invalido -> default
  assert.equal(resolveMaxConcurrentLaunches({ SPIDER_MAX_CONCURRENT_LAUNCHES: "abc" }, 4), 3);
});
