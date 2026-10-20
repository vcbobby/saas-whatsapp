"use client";

import { useEffect } from "react";

/** Al abrir /ayuda#tema el contenido llega en streaming; el navegador puede intentar el salto antes de que exista. Esto lo repite al montar. */
export function ScrollToHash() {
  useEffect(() => {
    const id = decodeURIComponent(window.location.hash.replace(/^#/, ""));
    if (!id) return;
    document.getElementById(id)?.scrollIntoView({ block: "start" });
  }, []);
  return null;
}
