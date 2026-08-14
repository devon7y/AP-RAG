import { googleAuthEnabled } from "../auth";
import { RegisterForm } from "./register-form";

export default function Page() {
  return <RegisterForm googleEnabled={googleAuthEnabled} />;
}
