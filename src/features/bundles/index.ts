import { Composer } from "grammy";
import { MyContext } from "../../core/types";
import { hubComposer, showAdminBundleHub } from "./hub";
import { reviewComposer } from "./review";
import { deletionComposer } from "./deletion";
import { setnameComposer } from "./setname";

export const managementComposer = new Composer<MyContext>();

managementComposer.use(hubComposer);
managementComposer.use(reviewComposer);
managementComposer.use(deletionComposer);
managementComposer.use(setnameComposer);

export { showAdminBundleHub };