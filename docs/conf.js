// Custom configuration for the c8080 playground.
//
// If the emulator runs on the same origin as this playground, set
// c8080EmulatorUrl to the path of its index.html — the playground will
// then hand binaries over through localStorage (`?handoff=<uuid>`),
// avoiding the URL-length cap that the cross-origin `?run=<dataUrl>`
// fallback runs into for large programs.
//
// Example (same-origin mirror at /emu/):
//   window.c8080EmulatorUrl = "../emu/";
//
// Leave commented out to target the public rk86.ru/beta emulator.
// window.c8080EmulatorUrl = "../";
