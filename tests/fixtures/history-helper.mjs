let busy = false;
process.on("message", ({ id, request }) => {
  if (request.now === 1) process.exit(1);
  if (request.now === 2) return; // deliberately unresponsive
  if (request.now === 3) {
    process.send({ id, error: "Fixture native binding unavailable" });
    return;
  }
  if (busy) {
    process.send({ id, error: "Overlapping requests" });
    return;
  }
  busy = true;
  setTimeout(() => {
    busy = false;
    process.send({ id, result: { pid: process.pid, now: request.now } });
  }, 25);
});
process.on("disconnect", () => process.exit(0));
