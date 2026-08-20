import { render } from "preact";
import { App } from "./app";
import "./styles.css";

const mountPoint = document.getElementById("app");
if (!mountPoint) {
  throw new Error("operator-console: #app mount point missing");
}

render(<App />, mountPoint);
