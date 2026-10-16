# Factibilidad: Jev como único modelo en runtime

Validación realizada el **16 de octubre de 2026** con Node.js 24, Chromium/Playwright y el modelo versionado **`jev-1.14.0`**. La credencial utilizada fue `JEV_API_KEY`; se verificó la API oficial con HTTP 200. No intervino ningún otro LLM en las ejecuciones del harness.

## Resultado

**Es viable para flujos de UI DOM con pasos atómicos, datos explícitos y assertions concretas.** La evidencia incluye una tienda local con controles y estados reales, un checkout completo en el sitio público de demostración SauceDemo y replay sin modelo. No demuestra un agente universal capaz de convertir cualquier objetivo libre en un test correcto.

El límite fundamental es que Jev decide entre alternativas; no genera cadenas, código ni planes abiertos. El harness aporta ese espacio de alternativas de forma determinista: catálogo de acciones, valores copiados de la instrucción y elementos observados. Playwright aporta la ejecución y la comprobación de resultados.

## Ejecuciones observadas

Los números son mediciones de ejecuciones individuales de validación, **no un benchmark estadístico**, percentiles ni un SLA. El tiempo incluye navegador y red; la captura de screenshots estuvo activada en las ejecuciones CLI y desactivada en la suite live.

| Escenario                                                   | Resultado        | Pasos |  Tiempo | Requests Jev | Tokens de entrada |
| ----------------------------------------------------------- | ---------------- | ----: | ------: | -----------: | ----------------: |
| Compra local en español, suite live final                   | Passed           |    14 | 7,073 s |           20 |            18.366 |
| Login con instrucciones en inglés y etiquetas de UI exactas | Passed           |     4 | 2,005 s |            7 |             4.972 |
| Credenciales incorrectas, error esperado visible            | Passed           |     4 | 1,955 s |            7 |             5.000 |
| Assertion deliberadamente falsa después del login           | Failed, esperado |     5 | 3,223 s |            8 |             5.831 |
| SauceDemo público, checkout final con capturas              | Passed           |    15 | 13,82 s |           22 |            21.563 |
| Replay local del checkout                                   | Passed           |    14 |  1,56 s |            0 |                 0 |
| Replay público de SauceDemo, `JEV_API_KEY` ausente          | Passed           |    15 |  7,71 s |            0 |                 0 |

En SauceDemo se ingresó con el usuario público de prueba, se eligió **Sauce Labs Backpack** entre productos con botones “Add to cart”, se verificó el carrito y se completó la compra de demostración. La aplicación no fue modificada ni instrumentada por el harness. Se usó el proxy HTTP del entorno para el navegador, manteniendo TLS habilitado.

Los reportes JSON incluyen la versión real devuelta por el API, uso de tokens, probabilidades, candidatos y acciones seleccionadas. Los artefactos de ejecución se excluyen de Git por defecto; los escenarios y los tests sí están versionados en el árbol de trabajo.

## Hallazgos que afectaron el diseño

1. **La formulación de la pregunta importa.** Al cambiar el contexto observado, la pregunta inicial llegó a asignar p=0,60 al botón exacto “Iniciar sesión”, bloqueando correctamente el paso. Se compararon tres formulaciones sobre el mismo estado: p=0,61, p=0,84 y p=0,95. Se adoptó la tercera, que identifica explícitamente `state.step` como instrucción y los criterios como datos. Luego pasaron nuevamente los cuatro escenarios locales y el checkout público. No se bajaron umbrales ni se añadieron reintentos de decisiones para intentar obtener un éxito.
2. **La equivalencia entre idiomas no es universal.** “Click the sign in button” frente a “Iniciar sesión” produjo decisiones insuficientemente confiables. El ejemplo reproducible usa “Click the \"Iniciar sesión\" button”. No se agregó un traductor ni otro LLM. Las instrucciones en español y en inglés funcionan en los escenarios verificados; otras paráfrasis necesitan evaluación.
3. **Una acción ejecutada no prueba el objetivo.** Se exige al menos una assertion y se verifica cada una con Playwright. El caso negativo confirmó que el texto inexistente termina en fallo, aunque el login anterior haya pasado.
4. **El replay elimina las decisiones del camino estable.** Ambos checkouts se reprodujeron sin solicitudes a Jev; el externo se ejecutó incluso quitando `JEV_API_KEY` del proceso. Esto permite revisar/resolver un caso en live y usar el plan en CI.
5. **La exactitud depende del espacio de candidatos.** Si un elemento no está observado, un valor no está en el paso o hay ambigüedad, el sistema debe bloquear. Un threshold alto no arregla una lista de candidatos incompleta.

## Comprobaciones de ingeniería

- `npm run check`: tipos de biblioteca, CLI, tests y ejemplos.
- `npm run build`: distribución ESM y declaraciones TypeScript.
- `npm test`: **16 pruebas aprobadas**, incluida ejecución real de Chromium; la suite live se omite aquí por diseño.
- `npm run test:live`: **4 escenarios contra Jev real**, dentro de una prueba de integración; tres positivos y un fallo esperado.
- Protocolo: rechaza elecciones inventadas, distribuciones inválidas, respuestas faltantes, falta de confianza, operaciones no soportadas y planes de replay inválidos.
- Transporte: comprueba reintentos limitados ante 429, ausencia de reintentos ante 401 y cancelación, sin exponer cuerpos de error ni credenciales.
- Navegador: formularios, selección, checks, estado enabled/disabled, assertions asíncronas, screenshots, shadow DOM abierto e iframe.
- Runner: cierre de recursos, variables faltantes, falta de assertions, cancelación durante ejecución/captura y ausencia de replay exitoso tras un fallo.

La suite automatizada usa Chromium. Firefox/WebKit están disponibles como opciones de adaptador, pero **no fueron ejecutados** en esta validación. No se ejecutó la workflow de GitHub Actions en remoto.

## Qué falta para afirmar confiabilidad de producto

Hace falta un corpus de aplicaciones y casos del usuario, con intención y objetivos etiquetados. Las métricas relevantes son: operación y target correctos, aceptación de valores, tasa de bloqueo, falsos positivos de assertions, estabilidad ante cambios de DOM, latencia y costo por caso. Es necesario incluir instrucciones ambiguas, idiomas, errores reales y elementos duplicados, no sólo flujos exitosos.

Este PoC entrega la infraestructura para esa evaluación y una demostración funcional de la hipótesis. La interpretación sigue siendo probabilística; incluso una assertion determinista puede apuntar al elemento equivocado si se interpretó mal el paso. Los reportes y el replay hacen esa decisión revisable. Para canvas, objetivos abiertos, datos que deban inventarse, planificación larga o UI inaccesible, el diseño actual necesita más código/candidatos o una ampliación explícita del alcance.

## Fuentes del contrato de Jev

- [API oficial](https://docs.typesafe.ai/api): `POST /v1/systemone`, state, questions y respuestas tipadas.
- [Choice](https://docs.typesafe.ai/primitives/choice): selección y distribución de probabilidades; máximo de 255 opciones.
- [Extracción de valores preparseados](https://docs.typesafe.ai/cookbooks/pre_parsed_value_extraction_cookbook): código encuentra candidatos, Jev elige y código copia el valor.
- [Modelos](https://docs.typesafe.ai/models): versiones, límites de contexto y limitaciones de idioma.
- [Confianza](https://docs.typesafe.ai/confidence): relación entre probabilidad y confianza; no equivalen a una garantía de acierto.
