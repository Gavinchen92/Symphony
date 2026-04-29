import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("未找到页面根节点");
}

createRoot(root).render(<App />);
