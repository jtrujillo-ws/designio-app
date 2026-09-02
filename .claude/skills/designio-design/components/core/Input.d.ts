export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  /** Datos/códigos en Plex Mono */
  mono?: boolean;
}
export declare function Input(props: InputProps): JSX.Element;