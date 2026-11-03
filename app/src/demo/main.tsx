import "../global.css";
import { setDemoRuntimeConfig } from "@/lib/runtime-config";

setDemoRuntimeConfig();

const container = document.getElementById("root");
if (!container) throw new Error("The demo root element is missing.");

void import("../root")
    .then(({ mountDemoApp }) => mountDemoApp(container))
    .catch((error: unknown) => {
        console.error(error);
        container.textContent = "The demo couldn't start. Refresh the page to try again.";
    });
