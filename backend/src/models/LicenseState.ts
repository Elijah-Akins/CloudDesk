import mongoose, { Schema } from 'mongoose';

/**
 * Single document recording this deployment's identity towards the license
 * server and the last successful license validation, so a restart during a
 * license-server outage doesn't drop a paid deployment to the Community tier.
 */
export interface ILicenseState {
  _id: string;
  /** Stable UUID the license server uses to tell deployments apart */
  instanceId: string;
  /** SHA-256 of the license key the cached validation belongs to */
  keyHash?: string;
  /** Response data from the last successful validation */
  validation?: Record<string, unknown>;
  validatedAt?: Date;
}

export const LICENSE_STATE_ID = 'license';

const licenseStateSchema = new Schema<ILicenseState>(
  {
    _id: { type: String, required: true },
    instanceId: { type: String, required: true },
    keyHash: { type: String },
    validation: { type: Schema.Types.Mixed },
    validatedAt: { type: Date },
  },
  {
    collection: 'license_state',
    timestamps: true,
    versionKey: false,
  }
);

export const LicenseState = mongoose.model<ILicenseState>('LicenseState', licenseStateSchema);

export default LicenseState;
