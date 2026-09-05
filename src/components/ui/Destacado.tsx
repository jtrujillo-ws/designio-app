import { useEffect, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';

/**
 * Un elemento de una lista que puede llegar «destacado» desde fuera (un resultado de
 * búsqueda). Cuando su id coincide con el pedido se lleva el scroll y un borde de acento
 * unos segundos, y luego vuelve a ser uno más: el destaque orienta, no clasifica.
 */
export function Destacado({
  id,
  destacado,
  children,
}: {
  id: string;
  destacado: boolean;
  children: ReactNode;
}) {
  const [encendido, setEncendido] = useState(destacado);
  useEffect(() => {
    // Al dejar de ser el destacado (cambia `destacar` antes de que venza el tiempo) se apaga
    // aquí mismo: el cleanup solo cancela el temporizador, no apaga nada.
    if (!destacado) {
      setEncendido(false);
      return;
    }
    setEncendido(true);
    document.getElementById(idDeDestacado(id))?.scrollIntoView({ block: 'center' });
    const t = setTimeout(() => setEncendido(false), 4000);
    return () => clearTimeout(t);
  }, [destacado, id]);
  const estilo: CSSProperties = encendido
    ? {
        outline: '2px solid var(--accent)',
        outlineOffset: 4,
        borderRadius: 14,
        transition: 'outline-color .6s',
      }
    : { transition: 'outline-color .6s' };
  return (
    <div id={idDeDestacado(id)} style={estilo}>
      {children}
    </div>
  );
}

export function idDeDestacado(id: string): string {
  return `destacado-${id}`;
}

/**
 * Cuando lo pedido no está entre lo cargado: la lista es paginada y el elemento puede vivir
 * más abajo. Decirlo es mejor que dejar al usuario buscando a ojo lo que ya encontró.
 */
export function AvisoDeDestacadoAusente({ que }: { que: string }) {
  return (
    <span role="status" style={{ font: '400 12.5px var(--font-sans)', color: 'var(--text-muted)' }}>
      {que} que buscabas no está entre lo cargado en esta página: sigue con «cargar más» o vuelve al
      buscador.
    </span>
  );
}
