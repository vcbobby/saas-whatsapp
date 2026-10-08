import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import { brand } from '@/config/brand'
import './globals.css'

// Inter con eje de tamaño óptico: a tamaños grandes se comporta como "Inter Display".
const inter = Inter({
    subsets: ['latin'],
    axes: ['opsz'],
    variable: '--font-inter',
    display: 'swap',
})

export const metadata: Metadata = {
    title: { default: brand.name, template: `%s · ${brand.name}` },
    description: 'Agentes de IA para atender a tus clientes por WhatsApp.',
}

export default function RootLayout({ children }: LayoutProps<'/'>) {
    return (
        <html lang="es" className={`${inter.variable} h-full`}>
            <body className="min-h-full flex flex-col" suppressHydrationWarning>
                {children}
            </body>
        </html>
    )
}
