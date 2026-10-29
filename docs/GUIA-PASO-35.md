# Paso 35 — Importar y exportar (Excel / CSV)

Nueva pantalla **Importar y exportar** (menú «Cuenta», solo dueño y administradores) y un enlace desde Catálogo.

## Importar productos
1. Descarga la **plantilla** (para Excel en español o CSV estándar), o descarga tus productos actuales y edítalos.
2. Una fila por producto. Columnas: **Nombre** y **Precio** (obligatorias), Descripción, Presentación, Stock, Avisar cuando queden. Los encabezados se reconocen con o sin acentos y con otros nombres comunes (Producto, Unidad, Existencias, Mínimo…). Las columnas que no conoce las ignora y te lo dice.
3. Guárdalo como **CSV** (Excel: Archivo → Guardar como → «CSV (delimitado por comas)»). Excel en español usa «;» y coma decimal: se detecta solo. No se lee `.xlsx` directamente.
4. Súbelo: aparece una **vista previa** con cuántos productos se crearán, actualizarán, quedarán igual o tienen error (y por qué, fila por fila). **No se cambia nada hasta que pulses «Importar».**

Reglas:
- Si ya existe un producto activo con ese nombre (sin importar mayúsculas), se **actualiza**, solo con las columnas que llenes. **Una celda vacía nunca borra nada.** Para quitar el control de stock escribe `sin control`.
- Precio: `10`, `10,50` o `10.5` (se aceptan `$`, `Bs`, `€` delante). Sin separador de miles.
- Máximo 2.000 filas, 1 MB y 500 productos activos. Las filas con error se omiten; las demás sí se importan. Nada se borra con una importación.
- Cada importación queda en el registro de actividad (`catalog.imported`) y el stock cambiado queda en el historial de inventario como «Edición».
- Dos importaciones a la vez en el mismo negocio se atienden una tras otra, y al aplicar se vuelve a calcular todo con los datos de ese momento.

## Exportar
Clientes, pedidos (con sus productos), citas y productos. Pedidos y citas aceptan rango de fechas (en la hora de tu negocio). Dos formatos: **Excel en español** (separador `;`, decimales con coma) y **CSV estándar** (coma, decimales con punto). Todos llevan BOM para que Excel respete los acentos.
- Lo exportado como «Productos» tiene las mismas columnas que la plantilla: puedes editarlo y volver a subirlo.
- Los textos que empiezan por `=`, `+`, `-` o `@` se marcan con una comilla para que Excel no los ejecute como fórmula (los teléfonos con `+58…` y los números negativos se dejan tal cual).
- Cada descarga queda en el registro de actividad (`data.exported`). Tope: 50.000 filas por archivo.
- Permisos: clientes y productos, dueño/administrador; pedidos y citas, también agentes (si el plan incluye el módulo) a través de la dirección `/api/export`.

## Aparte
- Corregido: en el CSV de movimientos de inventario, los cambios negativos (`-3`) salían como `'-3`; ahora salen como número.

## Qué falta / límites
- No se importan clientes, pedidos ni citas (solo productos). Eso se puede agregar si lo necesitas.
- No hay lectura de `.xlsx` real (evité una librería con historial de vulnerabilidades); se pide guardar como CSV.

## Aplicar
```bash
bash aplicar-paso-35.sh
npm run typecheck && npm run lint && npm test
```
No hay migración nueva.
