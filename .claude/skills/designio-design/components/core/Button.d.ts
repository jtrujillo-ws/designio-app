/** @startingPoint section="Componentes" subtitle="Botón: primary, arco, secondary, ghost, danger" viewport="700x220" */
export interface ButtonProps {
  variant?: 'primary' | 'arco' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
  disabled?: boolean;
  children: React.ReactNode;
  onClick?: () => void;
}
export declare function Button(props: ButtonProps): JSX.Element;