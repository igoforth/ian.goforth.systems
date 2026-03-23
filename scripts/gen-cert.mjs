// @ts-check
import { spawn } from "node:child_process";

const keyFile = "key.pem";
const certFile = "cert.pem";

/**
 * Executes a shell command and returns a promise
 * @param {string} command
 * @param {string[]} args
 */
function execCommand(command, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { stdio: "pipe" });

    let stderr = "";
    proc.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      if (code === 0) resolve(undefined);
      else reject(new Error(`Command failed with code ${code}: ${stderr}`));
    });

    proc.on("error", reject);
  });
}

// Generate RSA private key
await execCommand("openssl", [
  "genpkey",
  "-algorithm",
  "RSA",
  "-pkeyopt",
  "rsa_keygen_bits:2048",
  "-out",
  keyFile,
]);

// Generate self-signed certificate
await execCommand("openssl", [
  "req",
  "-new",
  "-x509",
  "-key",
  keyFile,
  "-out",
  certFile,
  "-days",
  "365",
  "-subj",
  "/CN=localhost",
  "-addext",
  "subjectAltName=DNS:localhost,IP:127.0.0.1",
]);
