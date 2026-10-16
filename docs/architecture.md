# Diseño del harness

## Contratos

- `DecisionProvider.decide(state, questions, signal)` devuelve respuestas Choice tipadas. `JevProvider` implementa el protocolo oficial `POST /v1/systemone`, valida el esquema y que cada elección pertenezca a los criterios, comprueba distribuciones y controla timeouts/reintentos. El transporte sólo conoce la API de TypeSafe.
- `DecisionEngine` clasifica pasos en lotes de hasta ocho, elige literales y resuelve elementos. Usa opciones `unsupported`/`none`, nunca un fallback generativo. Registra la petición redactada y la respuesta, lo que permite auditar las alternativas y calibrar la política con casos propios.
- `PlatformAdapter` abre la plataforma, observa candidatos, ejecuta acciones y genera evidencia. `BrowserAdapter` es la primera implementación. El contrato de candidato/localizador conserva terminología DOM en este PoC; extenderlo a móvil requiere versionar/generalizar ese contrato.
- `runCase` controla el orden, presupuesto total, cancelación, resolución de variables, cierre de recursos y resultados. No decide el éxito mediante el modelo. La API acepta un callback por paso y proveedores/adaptadores inyectados.
- `saveArtifacts` persiste JSON, HTML, JUnit y replay. Los directorios nuevos evitan confundir evidencia vieja con un fallo reciente. El replay usa el mismo adaptador y las mismas assertions.

## Decisiones cerradas

1. Validación de caso. Cada paso tiene hasta 2000 caracteres, hay hasta 100 pasos. URLs iniciales sólo HTTP(S).
2. Jev elige una operación del catálogo. Una instrucción compuesta debe resultar `unsupported`; esta detección sigue siendo probabilística, por lo que se exige autoría atómica y revisión de evidencia.
3. Para operaciones con argumento, código extrae comillas, referencias o spans contiguos; Jev elige un candidato o `none`. No se inventan valores. Para datos generados, se pueden preparar variables determinísticamente antes de llamar al harness.
4. Antes de operar, Playwright obtiene un snapshot de controles/textos. El motor filtra por compatibilidad (un fill no puede apuntar a un botón) y ofrece hasta 240 candidatos. Superar el límite bloquea explícitamente; no se trunca silenciosamente el conjunto elegible.
5. Jev elige un objetivo. La política requiere probabilidad, margen sobre la segunda opción y confianza suficientes. Probabilidad y confianza no son garantías de exactitud; sus umbrales deben calibrarse con el corpus del usuario.
6. Playwright ejecuta una operación cerrada usando localizador estricto. Se prefieren test id, label o role/name únicos; si no, CSS observado. No se aceptan selectores generados por Jev, ni evals, ni acciones inventadas.
7. Las assertions se implementan con `expect`/poll de Playwright. Sólo la ejecución satisfactoria de todas las acciones y assertions produce `passed`.

Las assertions de página (texto y URL) no necesitan una selección de elemento. Las assertions de control sí usan Jev para interpretar a qué control se refiere el paso, y Playwright para medir su estado. Esto elimina un juez LLM del resultado pero no elimina errores de interpretación: siempre es necesario revisar que el caso resuelto representa la intención.

## Navegación, selectores y asincronía

Cada run abre un contexto aislado. El inicio es `baseUrl`; las rutas explícitas de navegación/URL se resuelven respecto de esa URL. El adaptador impide navegación de documentos hacia otros orígenes salvo allowlist, incluidos iframes. Puede cargarse `storageState` para sesiones preparadas externamente. Los popups se detectan como no soportados.

Los localizadores se resuelven de nuevo al actuar. Playwright exige unicidad y actionability; un snapshot no garantiza que un DOM que cambió entre decisión y acción mantenga la misma identidad. Los localizadores CSS estructurales y los índices de frame tienen limitaciones explícitas. Para aplicaciones críticas, preferí test ids estables y validación de identidad específica en un adaptador propio.

No se reintentan acciones con efectos. Las assertions usan autoespera. La resolución de objetivos actualmente toma un snapshot por paso: no hay búsqueda autónoma, scroll exploratorio o recuperación de rutas. Las listas enormes, controles no expuestos en el DOM y pasos abiertos se bloquean.

## Variables y reproducibilidad

`${NAME}` se conserva como referencia durante las decisiones; `env:NAME` carga un valor en el runner. Los valores de variables se sustituyen sólo al ejecutar el argumento. El CLI también los usa para enmascarar screenshots. La API de biblioteca permite suministrar `maskValues` al adaptador cuando se requiere el mismo enmascaramiento. Los campos de formulario siempre se enmascaran.

Los planes de replay se validan con Zod y no contienen código. Se exportan solamente de runs exitosos, conservan versiones de formato y no requieren proveedor. Los valores inline de variables se sustituyen por referencias de entorno en el plan. Si un localizador contiene literalmente un secreto que se redacta, el replay puede fallar: no se reconstruyen localizadores secretos. Las fixtures deben dar identidades estables a los controles.

El modelo se fija por defecto a `jev-1.14.0`. Cambiar modelo o política requiere volver a ejecutar el corpus de evaluación, no asumir equivalencia. No se ofrece una garantía estadística a partir de los escenarios de demostración.

## Próximas extensiones razonables

- Corpus versionado con etiquetas de operación/target y métricas de exactitud, rechazo y falsos positivos por idioma/UI.
- Proveedores de candidatos especializados para componentes del producto, identidad robusta de frames y renderizados virtuales.
- Fixtures/setup/teardown explícitos y resolución determinista de datos generados.
- Assertion plugins con contratos tipados y validaciones específicas de dominio.
- Cola de ejecuciones, aislamiento por usuario y editor web sobre la API existente.

Estas extensiones no están implementadas ni son necesarias para ejecutar los ejemplos actuales.
