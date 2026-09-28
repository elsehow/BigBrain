import { initialActivation } from "./activation";
const query = new URLSearchParams(location.search);
export const activation = $state({ value: initialActivation(query.get("scene") === "active", query.get("auth") === "fail") });
