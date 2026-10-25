// Comprueba que la IA está bien configurada: hace UNA pregunta corta con la clave de .env.local. Ejecuta:  npm run ai:check
// No imprime la clave. Si la IA está en modo «mock», lo avisa (en ese modo no hay ningún modelo conectado).
async function main() {
    const { getLlmEnv } = await import('../src/lib/env')
    const { getLlmProvider } = await import('../src/lib/ai')
    const { runAiCheck } = await import('../src/lib/ai/check')

    let env
    try {
        env = getLlmEnv()
    } catch (e) {
        console.error(
            '✖ La configuración de IA no es válida:',
            e instanceof Error ? e.message : e,
        )
        console.error(
            '  Revisa en .env.local: LLM_PROVIDER, LLM_MODEL y LLM_API_KEY.',
        )
        process.exit(1)
    }
    if (env.LLM_PROVIDER === 'mock') {
        console.error(
            '⚠ LLM_PROVIDER=mock: no hay ningún modelo conectado (responde un texto fijo). Pon LLM_PROVIDER=gemini, LLM_MODEL y LLM_API_KEY.',
        )
        process.exit(1)
    }
    console.log(
        `Proveedor: ${env.LLM_PROVIDER} · modelo: ${env.LLM_MODEL} · clave: ${'•'.repeat(8)}${env.LLM_API_KEY?.slice(-4) ?? ''}`,
    )
    const r = await runAiCheck(getLlmProvider())
    console.dir(r, { depth: null })
    if (!r.ok) {
        console.error(`✖ ${r.message}`)
        process.exit(1)
    }
    console.log(`✔ ${r.message}`)
    console.log(`  Respuesta: «${r.text}»`)
    console.log(
        `  Tokens: ${r.inputTokens} de entrada, ${r.outputTokens} de salida · ${r.ms} ms`,
    )
}
void main()
