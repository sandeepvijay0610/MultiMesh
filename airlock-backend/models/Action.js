'use strict';

const mongoose = require('mongoose');

const ACTION_STATUS = Object.freeze({
  PENDING_APPROVAL: 'PENDING_APPROVAL',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
});

function baseTransform(doc, ret) {
  if (ret._id !== undefined && ret._id !== null) {
    ret.id = ret._id.toString();
  }
  delete ret._id;
  delete ret.__v;
  return ret;
}

const actionSchema = new mongoose.Schema(
  {
    environmentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Environment',
      required: true,
      index: true,
    },
    toolName: {
      type: String,
      required: [true, 'toolName is required'],
      trim: true,
    },
    parameters: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    status: {
      type: String,
      enum: Object.values(ACTION_STATUS),
      default: ACTION_STATUS.PENDING_APPROVAL,
      index: true,
    },
  },
  {
    timestamps: true,
    minimize: false,
    toJSON: {
      virtuals: true,
      versionKey: false,
      transform(doc, ret) {
        return baseTransform(doc, ret);
      },
    },
    toObject: {
      virtuals: true,
      versionKey: false,
      transform(doc, ret) {
        return baseTransform(doc, ret);
      },
    },
  }
);

actionSchema.index({ environmentId: 1, status: 1, createdAt: -1 });

actionSchema.statics.STATUS = ACTION_STATUS;

module.exports = mongoose.models.Action || mongoose.model('Action', actionSchema);